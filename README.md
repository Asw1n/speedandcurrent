# **Speed Correction & Current Estimation Plugin**

## **Overview**
This SignalK plugin estimates **corrected speed through water**, **leeway**, and **water current** in real-time using advanced filter techniques. The plugin continuously refines its estimates based on vessel speed, heading, ground speed, and heel angle.

### **Key Features**
- ✅ Real-time estimation of vessel speed (STW).
- ✅ Real-time estimation of leeway.
- ✅ Real-time estimation of water current (both speed and direction).
- ✅ Adaptive learning: The plugin refines corrections over time.
- ✅ A web app to provide real-time insights into the plugin's operation.
- ✅ Use of Kalman filters for optimal estimations of the correction table, boat speed, and current.
- ✅ A user-configurable 2D correction table for speed errors based on heel and speed.

## **Introduction**
The plugin is based on the idea that a vessel's speed sensor is imperfect and can be corrected. Speed sensors, most often paddle wheels, are imperfect for two reasons:
1. **Measurement Precision**: The water flow over the hull influences the paddle wheel's measurement.
2. **Leeway**: A paddle wheel does not measure lateral speed or leeway, which is crucial for sailing vessels.

A GPS sensor provides the vessel's speed over ground, which differs from the paddle wheel's speed through water when there is current. The GPS sensor also has its imperfections.

In theory, one could use the GPS sensor to estimate the paddle wheel's error. However, estimating the paddle wheel's error requires knowing the water current, which cannot be measured directly from a floating vessel. Given enough measurements, one could estimate both current and paddle wheel error.

The plugin estimates both current and sensor error simultaneously. Using these estimations, the plugin corrects boat speed, estimates leeway, and estimates the current in real-time.

### **Assumptions**
- The paddle wheel's error depends on boat speed and heel angle, and it may change slowly over time.
- The speed and direction of the current change slowly and gradually.
- The vessel changes direction regularly.

## **Configuration of the Plugin**

### **1. Plugin Mode**
The plugin has different modes optimized for various circumstances. If there is no (or very little) current, use one of the no-current modes for the best paddle wheel corrections. If there is current, select one of the modes that account for current.

You must start with a mode that creates a new correction table. These modes use the specified dimensions to create an empty correction table. Once the table is created, the plugin will automatically switch to one of the fresh correction table modes. Be careful when selecting to start with a new correction table, as the previous table will be permanently deleted.

The modes that assume a fresh correction table are optimized to estimate valid correction values quickly. Corrections are not applied, and no leeway or current is estimated. Once the correction table has matured, select one of the mature correction table modes. In these modes, corrections are calculated and updated conservatively, and corrections are applied to the boat speed. Leeway and, optionally, current are estimated.

If circumstances are very dynamic (e.g., unstable wind, currents, or big waves), you can lock the correction table. Corrections will no longer be updated but will be applied.

| Mode | Updates Correction Table | Assume Current | Correct Boat Speed | Estimate Leeway | Estimate Current |
|------|--------------------------|----------------|---------------------|-----------------|------------------|
| Start with new correction table, no current | Yes, starting with a new one | No | No | No | No |
| Start with new correction table, with current | Yes, starting with a new one | Yes | No | No | No |
| Fresh correction table, no current | Fast | No | No | No | No |
| Fresh correction table, with current | Fast | Yes | No | No | No |
| Mature correction table, no current | Slow | No | Yes | Yes | No |
| Mature correction table, with current | Slow | Yes | Yes | Yes | Yes |
| Locked correction table | No | Yes | Yes | Yes | Yes |

### **2. Correction Table**
The other parameters for the plugin deal with the correction table. These include step size for heel and speed, and maximum heel and speed.
- The correction table should cover the vessel's normal dynamic range. Set maximum speed and maximum heel to values the vessel would typically achieve. Avoid setting values for exceptional circumstances, as this may result in unreliable estimations.
- Choose the step size carefully. Too small step sizes may lead to insufficient observations for a good estimation, while too large step sizes may result in imprecise corrections.
- Changing any table dimensions will result in the loss of all existing estimations.

## **WebApp**
The plugin comes with a WebApp that allows you to view the correction table and see the estimations in real-time. The WebApp can be launched from the SignalK server. The WebApp:
- Graphically shows the boat speeds (observed and estimated), ground speed, current, and correction.
- Displays incoming deltas.
- Displays the boat speeds (observed and estimated), ground speed, current, and correction.
- Displays the content of the correction table in either Cartesian values or polar coordinates.
- Displays the plugin configuration and internal settings.

The graphical representation of the speed vectors, current vector, and correction vector can be embedded in KIP displays using the path `/speedandcurrent/vectors.html`.

---

## **How It Works**

### **1. Speed Correction Model**
- Vessel speed errors depend on **heel** and **speed** and are assumed constant for a given speed and heel angle.
- A correction table stores speed errors for steps in speed and heel angle.
- Each cell in the correction table contains a **Kalman filter** that updates speed corrections with new measurements.
- The speed measurement is corrected by subtracting the correction from the correction table. The correction is **interpolated** based on nearby table cells, weighted by the uncertainty provided by the Kalman filter.
- ![correction model](https://github.com/Asw1n/speedandcurrent/raw/main/correctionModel.png)

### **2. Current Estimation Model**
- The water current is estimated as a **slowly changing** vector.
- A **Kalman filter** updates the current based on the difference between GPS speed and corrected speed.
- ![current estimation model](https://github.com/Asw1n/speedandcurrent/raw/main/currentModel.png)

---


